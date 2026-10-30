---
subjects:
  - src/application/primitives/ref-store.ts
  - src/application/commands/internal/fsck/refs-verify.ts
  - src/application/commands/internal/fsck/roots.ts
  - test/unit/application/commands/fsck-symbolic-ref-fault.test.ts
---
# 1122 — fsck reports an unreadable loose ref file as `cannotReadRef` and continues, as git 2.56 does

- **Status:** accepted
- **Date:** 2026-10-30
- **Design:** docs/design/fsck-broken-ref-chain-unreadable.md (D2) · **Supersedes/Refines:** refines ADR-226 and ADR-1072; distinguishes ADR-1116

## Context

Pinned on git 2.56.0: a loose `refs/heads/b` with mode 000 prints
`error: cannot read ref file '.git/refs/heads/b': Permission denied` plus a zero pointer for `b`
and for every ref whose chain reaches it, and exits 10 — the same in default mode, under
`--strict` and under `--connectivity-only`; under `--no-references` only the pointers remain
(exit 2). git never dies. tsgit throws `PERMISSION_DENIED` out of the integrity check before the
snapshot runs, and `fsck-symbolic-ref-fault.test.ts` pins that a permission fault on a symref
chain read propagates. ADR-1116 chose refusal for an unreadable loose **object** under
`--connectivity-only` because git itself dies there with exit 128; that is the object database's
reader, not the files ref backend. The linked-worktree HEAD already reports
`{ msgId: 'cannotReadRef', path, reason: 'PERMISSION_DENIED' }` with an absolute `path`.

## Options considered

1. **Finding `cannotReadRef` with the absolute path tsgit opened and `reason: 'PERMISSION_DENIED'`,
   gated by `checkReferences`, bit 8; a chain read hitting the fault yields the zero pointer**
   (designer's recommendation) — pros: git's behaviour in every mode, the existing worktree-HEAD
   shape / cons: the symbolic-ref-fault pin must be re-pinned.
2. **The same finding with a gitdir-relative `path`** — pros: closer to git's default text / cons:
   git's text depends on how it was invoked (`.git/…`, an absolute `--git-dir`, the realpath for a
   linked worktree), so no relative form is git's.
3. **Refusal: keep throwing under a diverging ADR** — pros: no change / cons: a crash git does not
   have (lesson 017), in every mode.

## Decision

**Ratified by the user: option 1.** A `PERMISSION_DENIED` met while the refs pass reads a loose
ref file is a `bad-ref` finding `{ msgId: 'cannotReadRef', path: <absolute path opened>, reason:
'PERMISSION_DENIED' }`, severity error, not re-typeable by any `fsck.<msg-id>`, gated by
`checkReferences`, contributing bit 8. The same fault met while resolving a chain maps to the
zero pointer (bit 2). The run never throws `PERMISSION_DENIED` from the refs pass; every other read
fault still propagates. The linked-worktree HEAD finding becomes gated by `checkReferences` and
fires only when the HEAD file itself is unreadable; a HEAD whose target is unreadable is skipped,
as git prints no HEAD line. ADR-1116 stands unchanged for loose objects.

## Consequences

- `fsck-symbolic-ref-fault.test.ts` re-pins the permission row to the zero pointer (exit 2) and
  keeps propagation for an unclassified fault.
- A caller that caught `PERMISSION_DENIED` from `fsck` for a ref file now reads the finding.
- Under `--no-references` an unreadable linked-worktree HEAD reports nothing and exits 0.
