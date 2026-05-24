# 19.3b — Scanner support for two-stage call shapes (`skipIf` / `runIf`)

## Problem

`tooling/test-pyramid/scan-it-blocks.ts` and `tooling/test-pyramid/scan-describe-blocks.ts` are the regex/brace parsers that feed every per-heuristic detector (`gwtTitle`, `aaaBody`, `sutNaming`, `bareClassToThrow`, `emptyAaaSection`, `underAssertedUnit`, …). Both scanners locate the title literal in the **first** `(…)` after the opener — which is correct for `it('title', body)` and `it.skip('title', body)`, and which is special-cased for `it.each([…])('title', body)` (title moves to the **second** `(…)`).

Vitest also ships two more two-stage helpers that the scanners do **not** recognise:

| Shape | First `(…)` | Second `(…)` | Today |
|---|---|---|---|
| `it.skipIf(cond)('title', body)` | condition expression | title + body | **dropped silently** |
| `it.runIf(cond)('title', body)` | condition expression | title + body | **dropped silently** |
| `describe.skipIf(cond)('title', body)` | condition expression | title + body | **dropped silently** |
| `describe.runIf(cond)('title', body)` | condition expression | title + body | **dropped silently** |

`it.skip` / `describe.skip` already work because the title literal sits in the immediate parens (no two-stage wrap). It is only the `…If(cond)(…)` shape that breaks the title extractor.

Two existing unit tests document the limitation as a known bug (`scan-it-blocks.test.ts:218` / `:232`) and `scan-it-blocks.ts:13–18` carries a pointer to `BACKLOG 19.3b`. The library uses `describe.skipIf` heavily across `test/integration/network/*.test.ts`, `test/integration/sparse-*.test.ts`, and `test/integration/reflog-writers.test.ts`. Those files live in the **integration** tier; every gated heuristic (`gwtTitle`, `aaaBody`, `sutNaming`, `bareClassToThrow`, `emptyAaaSection`, `underAssertedUnit`) is scoped to the **unit** tier, so today's missed extractions do not actually leak findings in CI — but they will the moment a unit test reaches for `it.skipIf` / `it.runIf`. The fix closes the blind spot proactively.

## Goal

Make the scanners treat `…If(cond)(…)` the same shape as `each([…])(…)` — extract the title from the inner call so every downstream detector fires on these tests.

## Non-goals

- **Three-stage chains** like `it.skipIf(a).each([…])('title', body)` — not used in the codebase; if a future use case appears, extend the scanner then.
- **Evaluating the condition.** The condition is a runtime expression (`process.platform`, `GIT === undefined`, …). The scanner is static and cannot decide whether the test runs.
- **Inferring `isSkipped` from the helper name.** `skipIf` may or may not skip; `runIf` may or may not run. See ADR.

## Design

### Scanner change (shared between both files)

Today the `each` branch is the only two-stage path:

```ts
const chainKeys = chain.split('.').filter((seg) => seg.length > 0);
const isEach = chainKeys.includes('each');
```

The change replaces `isEach` with a more general predicate. The set of chain segments that signal "title sits in the second `(…)`" expands to `each`, `skipIf`, `runIf`:

```ts
const TWO_STAGE_MODIFIERS = new Set(['each', 'skipIf', 'runIf']);
const isTwoStage = chainKeys.some((seg) => TWO_STAGE_MODIFIERS.has(seg));
```

The two-stage extraction body (skip whitespace, expect `(`, find matching close, point `titleStart`/`bodyEnd`/`consumedEnd` at the inner call) is **structurally unchanged** — only the trigger predicate widens.

Identical edit applies to `scan-describe-blocks.ts` (which has no `consumedEnd` tracking and therefore a slightly simpler control flow, but the same predicate change).

### `isSkipped` semantics for `skipIf` / `runIf`

Both helpers stay **non-skipped** at scan time (`isSkipped: false`). Rationale captured in ADR — short version: the scanner cannot evaluate the condition, and treating these as "skipped" would re-create today's bug (heuristics never fire on them).

`each` already returns `isSkipped: false` for the same reason — `it.each([…])('case %s', …)` runs every case unless an explicit skip modifier is also chained.

Chain segments **after** the first `(…)` (e.g. `it.skipIf(cond).skip(…)`) are not parsed by either scanner today — the regex captures the chain only up to the first `(`. Combining `…If` with a sibling modifier is therefore out of scope (and absent from the corpus).

### Failure modes (preserve current silent-drop behaviour)

The `each` branch already drops blocks silently when:
- The inner call never opens (`it.each([1,2,3]); it('valid', …)` → only the well-formed one returned).
- The inner call never closes (unbalanced parens).

`skipIf` / `runIf` inherit the same drop-silently failure modes via the shared two-stage extraction body. No new error paths.

### Files touched

| File | Change |
|---|---|
| `tooling/test-pyramid/scan-it-blocks.ts` | Replace `isEach` with `isTwoStage`; new `TWO_STAGE_MODIFIERS` constant; drop the BACKLOG-19.3b limitation comment. |
| `tooling/test-pyramid/scan-describe-blocks.ts` | Same shape change, no comment drop (it didn't carry one). |
| `tooling/test/unit/test-pyramid/scan-it-blocks.test.ts` | Invert the two limitation tests at `:218` and `:232` (now extract); add `skipIf` / `runIf` malformed-input drop-silently tests; add a `concurrent.skipIf` chain test. |
| `tooling/test/unit/test-pyramid/scan-describe-blocks.test.ts` | Add `describe.skipIf` and `describe.runIf` extraction tests plus the same malformed-input cases. |

Nothing else moves. No detector changes: they already consume `ItBlock` / `DescribeBlock` records and don't care which helper produced them.

## Testing strategy

Pure unit-level. New tests follow each file's existing style: `scan-it-blocks.test.ts` uses the legacy single-line `it('Given …, When …, Then …', …)` GWT form (allowed via `legacyItGwt`) wrapped in a transparent `describe('scanItBlocks', …)`; `scan-describe-blocks.test.ts` uses the modern describe-tree split. New cases mirror the existing `each` cases verbatim, just with the two-stage helper swapped in.

### `scan-it-blocks.test.ts`

| Case | Expectation |
|---|---|
| `it.skipIf(cond)('title', body)` | one block, `title === 'title'`, `isSkipped === false`, body contains the closure source |
| `it.runIf(cond)('title', body)` | one block, `title === 'title'`, `isSkipped === false` |
| `it.skipIf(cond)` with no follow-up call | block dropped silently; later `it('valid', …)` still emitted |
| `it.runIf(cond)('case %s', (n) => { expect(…)…` (inner never closes) | block dropped silently |
| `it.concurrent.skipIf(cond)('title', body)` | one block, `isSkipped === false` (no `skip` segment in chain) |

### `scan-describe-blocks.test.ts`

| Case | Expectation |
|---|---|
| `describe.skipIf(cond)('Given x', () => {})` | one block, `title === 'Given x'`, `isSkipped === false` |
| `describe.runIf(cond)('Given x', () => {})` | one block, `title === 'Given x'`, `isSkipped === false` |
| `describe.skipIf(cond)` with no follow-up call | block dropped silently |
| `describe.runIf(cond)('Given x', () => {` (inner never closes) | block dropped silently |
| Nested `describe.skipIf(cond)('outer', () => { describe('inner', …) })` | both blocks returned; inner span contained by outer |

### Regression check

After the scanner change, the existing `scan-it-blocks.test.ts:218`/`:232` cases are converted from "asserts dropped" to "asserts extracted" — the test names and AAA bodies are rewritten in place rather than added, to avoid leaving stale "known limitation" wording in the suite.

## Downstream effect

Once the scanners emit these blocks, the surrounding detectors (`gwtTitle`, `aaaBody`, `sutNaming`, `bareClassToThrow`, `emptyAaaSection`, `underAssertedUnit`) start linting them. **All current `it.skipIf` / `describe.skipIf` usages live in the integration tier**, where none of those gates apply, so the scanner change produces **zero new findings today**. The branch still re-runs the full audit before opening the PR to confirm the green outcome.

If a future unit-tier test uses `it.skipIf` / `it.runIf`, the gates will catch it on first commit — which is the point.

## Risks

- **Detector behaviour on conditional tests** — gated heuristics are unit-tier only, and no current unit test uses `…If`, so no findings surface today. The forward-looking guarantee is: heuristics check static text (titles, AAA markers, `sut` naming, etc.) which is condition-independent — there is no runtime semantics in any heuristic.
- **Mutation testing on the shared two-stage extraction body** — the body is already covered by the `each` tests; widening the trigger does not change line coverage but does demand each entry point (`each`, `skipIf`, `runIf`) be exercised so a mutant that prunes `TWO_STAGE_MODIFIERS` members is caught. The test plan above covers each entry with at least one happy-path test.
- **Three-stage shapes are still silently dropped.** Acceptable — none exist in the corpus. Documented as out of scope in this design.
