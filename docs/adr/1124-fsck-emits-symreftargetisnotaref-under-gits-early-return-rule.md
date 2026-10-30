---
subjects:
  - src/application/primitives/ref-store.ts
  - src/application/commands/internal/fsck/refs-verify.ts
  - src/domain/refs/symref-referent.ts
---
# 1124 — fsck emits `symrefTargetIsNotARef` under git's early-return rule

- **Status:** accepted
- **Date:** 2026-10-30
- **Design:** docs/design/fsck-broken-ref-chain-unreadable.md (D4) · **Supersedes/Refines:** refines ADR-226

## Context

Pinned on git 2.56.0: with `fsck.badReferentName=warn` or `ignore`, a `b` holding `ref: x..y`
prints `warning: refs/heads/b: symrefTargetIsNotARef: points to non-ref target 'x..y'` beside (or
instead of) the `badReferentName` line, exit 2; `b` holding `ref: foo/bar` prints only that
warning by default (exit 2, also under `--strict`); `fsck.symrefTargetIsNotARef=error` makes it
`error:` with exit 10. git checks the referent in one function and returns early when
`badReferentName` is graded error, so the second line appears only when the first is not an
error. tsgit never emits the msgId, so the severity rows of this change cannot match git without it.

## Options considered

1. **Fold: emit it as a `bad-ref` info finding under git's early-return rule** (designer's
   recommendation) — pros: one rule in the same check the change implements / cons: one more
   msgId in the public union's values.
2. **Out of scope: pin the severity rows minus that line and file an IMPACT** — pros: smaller diff /
   cons: three pinned rows diverge from git by one line each.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** A loose symref whose referent is neither a
root ref nor `refs/`-prefixed reports `bad-ref symrefTargetIsNotARef` with `referent`, default
severity info (no exit bit; a configured error contributes bit 8), gated by `checkReferences`,
never upgraded by `--strict`. It is dropped for a ref whose `badReferentName` is graded error.
The ref store reports the two facts independently; fsck applies the severities and the rule.

## Consequences

- The severity override rows (`badReferentName` warn/ignore, `symrefTargetIsNotARef` error/ignore)
  match git line for line.
- `ref: foo/bar` by default yields the warning and a zero pointer, exit 2.
