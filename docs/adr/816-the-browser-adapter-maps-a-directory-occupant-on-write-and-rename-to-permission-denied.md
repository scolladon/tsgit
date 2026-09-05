---
subjects:
  - src/adapters/browser/browser-file-system.ts
  - test/browser/opfs-roundtrip.spec.ts
---
# 816 — The browser adapter maps a directory occupant on write and rename to PERMISSION_DENIED

- **Status:** accepted
- **Date:** 2026-09-05
- **Design:** docs/design/memory-write-exclusive-directory.md (DC-G) · **Supersedes/Refines:** refines ADR-814

## Context

`BrowserFileSystem.write`, and the three surfaces that delegate to it, route through
`resolveFileHandle(path, true)`, whose catch maps every non-`TsgitError` rejection to
`fileNotFound(path)`. The WHATWG File System Standard rejects `getFileHandle` on a directory child
with `TypeMismatchError`, so a directory occupant surfaces as `FILE_NOT_FOUND` where the node
adapter and the memory target say `PERMISSION_DENIED`. `rename` is `read`, `write`, `rm` in
sequence and fails at the first two the same way, so nothing is corrupted and no half-move is
left. The failure stays inside the port's error contract, unlike the `writeExclusive` case
ADR-814 fixes. `resolveFileHandle` has nine callers, and `stat` and `exists` depend on its
current mapping to fall back to a directory handle, so a helper-wide change would break them.
All of this is derived from the adapter source and the normative spec; no OPFS fake exists.

## Options considered

1. **Out of scope; record the derivation** (designer's recommendation) — pros: the failure is
   in-contract and no known caller branches on a write's `FILE_NOT_FOUND` / cons: the
   cross-adapter guarantee stays partly false on the browser.
2. **Fix in this change, scoped to the `create: true` arm, pinned by two Playwright cases** —
   pros: all three adapters agree on every write surface / cons: scope growth and more Playwright
   time.
3. **Fix with no end-to-end pin** — cons: an unverified change on the ungated adapter.

## Decision

**Ratified by the user: option 2, against the design's recommendation.** `resolveFileHandle`
gains a `create: true`-only arm that maps `TypeMismatchError` to `permissionDenied(path)`; the
`create: false` mapping that `stat` and `exists` rely on is untouched. Two new cases in
`test/browser/opfs-roundtrip.spec.ts` plant a directory at the target and assert
`PERMISSION_DENIED` for `write` and for `rename`, against real OPFS on the browsers that file
already runs. Together with ADR-814's case the file carries three directory-occupant pins.

## Consequences

The three first-party adapters agree on every write surface's directory-occupant code. The
design is revised to carry the browser fix shape and the two cases before planning. The browser
adapter remains outside the coverage and mutation gates, so the Playwright cases are its only
proof.
