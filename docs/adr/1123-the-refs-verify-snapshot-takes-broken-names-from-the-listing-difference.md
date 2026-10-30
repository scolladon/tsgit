---
subjects:
  - src/application/commands/internal/fsck/refs-verify.ts
---
# 1123 — the refs-verify snapshot takes broken names from the listing difference

- **Status:** accepted
- **Date:** 2026-10-30
- **Design:** docs/design/fsck-broken-ref-chain-unreadable.md (D3) · **Supersedes/Refines:** refines ADR-874

## Context

`listRefs()` drops every name whose direct resolution throws, so a broken referent, an unreadable
file and a garbage body all vanish from the pointer snapshot, and git's one pointer per chain ref
cannot be emitted. The names are still reachable: `listRefNames()` walks the same directories and
the same `packed-refs` snapshot without resolving.

## Options considered

1. **Broken names = `listRefNames()` minus `listRefs()`, each a zero pointer, no re-read**
   (designer's recommendation) — pros: no port change, one extra readdir walk / cons: relies on the
   two listings walking the same set.
2. **Resolve every listed name through `resolveRef`, catching the broken set** — pros: one code
   path / cons: re-reads every loose file and probes a loose miss per packed name.
3. **A new `RefStore` method yielding `{ name, broken: true }`** — pros: explicit / cons: widens
   the port, both backends and every test double, for one caller.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** The pointer set is every name
`listRefNames()` yields; a name absent from `listRefs()`, other than `HEAD`, is a zero pointer.
`targetOf` maps the unreadable-ref codes, `REF_NOT_FOUND` and `PERMISSION_DENIED` to the zero oid
and rethrows anything else. The synthesised pointer in the content-notice collector is dropped:
the snapshot emits every pointer, in name order, which is git's order. A loose name shadowing a
packed one keeps the zero pointer because `listRefs` already refuses the packed fallback for a
walked name.

## Consequences

- No `RefStore` change; reftable is untouched.
- The listing difference is only well-defined while both walks see the same entries, so an
  unreadable directory must be skipped by the shared walk (ADR-1126), never thrown.
