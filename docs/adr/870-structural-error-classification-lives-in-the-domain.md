---
subjects:
  - src/domain/error-data-code.ts
  - src/domain/objects/error.ts
---
# 870 — Structural error classification lives in the domain

- **Status:** accepted
- **Date:** 2026-09-14
- **Design:** docs/design/session-caches-faithfulness-addendum.md (I, DC-I1) · **Supersedes/Refines:** none

## Context

Two helpers classify errors, on two different grounds. `errorDataCode`
(`src/application/primitives/internal/error-data-code.ts`, 15 importers) reads `data.code`
structurally, because in a mixed-module-graph harness — source-graph code over a dist-bundle
Context — an adapter's `TsgitError` is a different class identity than the importing module's, and
an `instanceof` test fails. `isObjectNotFound` (`src/domain/objects/error.ts`) still classifies by
`instanceof TsgitError`, and the domain cannot import the application-layer helper.

`isObjectNotFound` has ten production call sites (a symbol-reference search cross-checked with
a text search): the promisor lazy-fetch retry, `catFile`'s batch fold, `readCommit`'s
`ignoreMissing`, two closure readers, two `reflog` readers, two `bundle verify` checks and the
submodule tree walk. Every `OBJECT_NOT_FOUND` producer inside those try bodies is same-graph
application code, so for errors tsgit raises itself the class test and a structural test agree.
They disagree only for a value re-thrown verbatim through a Context port: a dist-bundle adapter or
promisor in a mixed graph, a dual-package (ESM and CJS) consumer, or a user adapter throwing a
duck-typed `{ data: { code } }`.

## Options considered

1. **Move `errorDataCode` to `src/domain/`, re-point its 15 importers, and build
   `isObjectNotFound` on it** (recommended, chosen) — pros: a pure `unknown → string` function sits
   in the innermost layer; one helper serves sixteen consumers. Cons: fifteen import edits.
2. **Keep the helper in the application layer; move `isObjectNotFound` next to it and re-point its
   ten call sites** — cons: evicts a domain-shaped guard from the domain.
3. **A second structural check inside `domain/objects/error.ts`** — cons: duplicates the helper.

## Decision

**Option 1.** `errorDataCode` moves to `src/domain/error-data-code.ts` unchanged in signature
(`(error: unknown) => string | undefined`) and with zero outward imports, and the application
module is deleted. `isObjectNotFound(err)` becomes `errorDataCode(err) === 'OBJECT_NOT_FOUND'`. A
value with no `data`, or a non-string `code`, still classifies as not missing.
`domain/objects/error.ts` keeps importing `TsgitError`, which its factories construct.

## Consequences

At the ten call sites a foreign-shaped `OBJECT_NOT_FOUND` is now folded exactly as a native miss:
the lazy-fetch retry fetches and retries, the batch yields a `missing` entry and continues,
`readCommit` records the id, the closure readers skip the object, the reflog readers mark it failed
or treat it as reachable, `bundle verify` reports the base unavailable or the prerequisite missing,
and the submodule walk returns no tree. No public surface changes; the architecture check pins the
import direction and the dead-code check the deleted module.

**Counted and out of scope:** 72 other `instanceof TsgitError` classifications remain in `src/` (73
before this change, `reflog.ts`'s `tryResolve` among them). They carry the same defect class and are
left for a sweep of their own rather than folded into this change.
