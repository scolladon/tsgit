# 703 — A typed refusal for cross-format bundle prerequisites

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/sha256-object-format.md (candidate N3) · **Refines:** ADR-695

## Context

git draws two conditions that tsgit currently cannot tell apart:

| condition | git |
|---|---|
| a prerequisite commit is merely **absent** | `error: Repository lacks these prerequisite commits:`, exit **1** |
| a prerequisite oid is in the **wrong algorithm** | `fatal: missing mapping of <oid> to <local-algo>`, exit **128** |

`bundle-verify.ts` maps `OBJECT_NOT_FOUND` into `missingPrerequisites`, so a cross-format
prerequisite would be reported with the absent-prerequisite shape — the 128-condition wearing the
1-condition's clothes.

## Options considered

1. **A new typed refusal** `{ oid, bundleAlgorithm, localAlgorithm }`, raised **before** the
   object lookup — pros: the two conditions stay distinct, and raising it before the lookup is
   what makes them distinguishable at all.
2. **Reuse ADR-695's widened `UNSUPPORTED_OBJECT_FORMAT`** — cons: that code is scoped to
   transport; reusing it here would make a code's meaning depend on its call site, which is
   precisely what a discriminated error union exists to prevent.
3. **Accept the divergence** — cons: reports a fatal condition as a recoverable one, and the
   caller's natural response to "lacks prerequisites" (fetch them) can never succeed.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

A distinct refusal carrying the oid and both algorithms, raised before the prerequisite lookup.

## Consequences

- The check must precede the lookup, so the width sweep's oid predicate (ADR-694) is what makes
  the condition detectable: a 64-hex prerequisite in a SHA-1 repository is not a missing object,
  it is an incompatible one.
- Three refusal families now stay distinct by tier and scope: acceptance (ADR-668/674), transport
  (ADR-695), and this bundle-local one — none reused across call sites.
- `bundle-verify.ts`'s existing `missingPrerequisites` mapping is narrowed rather than replaced,
  so the absent-prerequisite path keeps its exit-1 shape.
